# Step 7 — Standards & Maintainability Review: feat/541-contacts-csv

- **Skill applied**: `thermo-nuclear-code-quality-review` (loaded successfully), plus
  `.claude/rules/repworth.md`, `.claude/rules/design.md`, CLAUDE.md invariants #10/#12/#15,
  CONTEXT.md glossary "Solicitation contacts & visits", and the triaged deviations file
  (`docs/superpowers/plans/feat-541-contacts-csv-deviations.md` — all entries treated as ACCEPTED
  and not re-flagged).
- **Diff reviewed**: `git diff $(git merge-base origin/main HEAD)..HEAD` in
  `/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-541-contacts-csv`
  (+5,942 / −4; production ~2.5k lines across 18 production files, 12 test files, 1 migration).
- **Verdict**: **APPROVE with 5 non-blocking findings.** No presumptive blocker from the skill's
  list fires: no file crosses 1,000 lines, no spaghetti branching was added to shared flows, no
  logic landed in the wrong layer, no invariant #10/#12/#15 violation found. The module
  decomposition (parse kernel / ingest lane / upload lane / repo / worker composition root /
  failed-hook) is genuinely deep and well-bounded. The findings below are improvement-grade
  consistency and duplication issues, ranked most-severe first.

---

## Findings table (≥80% confidence only)

| # | Severity | Location | Finding | Standard violated |
|---|----------|----------|---------|-------------------|
| 1 | MEDIUM | `src/lib/solicitation/uploads.ts:64` (also ingest.ts:81,122,277; failed-hook.ts:76,80; ContactsClient.tsx:194,199,556; migration 086:28) | Upload status values `'pending'`/`'completed'`/`'failed'` are bare string literals in 5+ production files; `UploadStatus.status` and `UploadRow.status` are typed `string`, not a union — no single authoritative TS owner exists for the enum | repworth.md "Never do: string literals for … status — import the enum/constant from its single authoritative TS file"; engineering.md one-authoritative-owner |
| 2 | MEDIUM | `src/lib/shared/worker-types.ts:302` | `CsvIngestPayload` mixes camelCase domain fields (`uploadId`, `businessId`) with the snake_case `BasePayload` fields (`correlation_id`, `outbox_id`) in one wire object; every sibling payload in the file is snake_case | design.md "consistency is design information"; "comments justify a confusing interface → reconsider the boundary" |
| 3 | MEDIUM | `src/app/(authenticated)/dashboard/contacts/ContactsClient.tsx:71` | 893-line new client island bundles two independent concerns — upload state machine + polling + report rendering, and contact list + delete + pagination — whose only integration point is the `listEpoch` bump; the obvious two-file decomposition was not taken | thermo-nuclear rules 1/3 (decompose before sprawl); design.md combine/split by total complexity |
| 4 | LOW | `src/lib/solicitation/uploads.ts:109` (vs `src/lib/solicitation/ingest.ts:307`) | The stored-report JSONB boundary (string-guard → parse → object-shape check → cast to `IngestReport`) is implemented twice — `getUploadStatus`+`asReportRecord` and `parseStoredReport` — where the repo's own allowlist precedent (accounts.flags, provider_dispositions) uses one shared parser | engineering.md one-owner; CLAUDE.md JSONB-allowlist shared-parser precedent |
| 5 | LOW | `src/app/api/dashboard/contacts/route.ts:28` (repeated at `contacts/[id]/route.ts:44`, `uploads/[id]/route.ts:37`) | The identical ~10-line policy sequence (resolveDashboardRequest → aggregate → 400 `'A location scope is required'` → resolveDashboardLocation `'uniform-not-found'`) is triplicated byte-for-byte across the three new contacts routes in this one PR | engineering.md "same fact in multiple artifacts → choose one owner"; design.md pull complexity downward |

---

## Finding details

### 1. No authoritative owner for the upload-status enum (MEDIUM)

The migration's CHECK (`086_solicitation_contacts.sql:28-29`) is the only place the closed set
`('pending','completed','failed')` is written down as a set. In TypeScript:

- `uploads.ts` INSERTs the literal `'pending'` (line 47) and exposes `status: string` on
  `UploadStatus` (line 64).
- `ingest.ts` types `UploadRow.status: string` (line 81), compares `!== 'pending'` (line 122), and
  the union `'completed' | 'failed'` exists only as an inline parameter type on `terminalizeUpload`
  (line 277).
- `failed-hook.ts` writes `'failed'` and predicates on `status = 'pending'` (lines 76, 80).
- `ContactsClient.tsx` branches on `status.status !== 'pending'` (194), `=== 'completed'` (199),
  `=== 'failed'` (556) — against a plain `string`.

**Failure scenario**: a typo (`'complete'`) or a future fourth status compiles silently everywhere;
adding a status is a 5-file sweep with zero compiler assistance, and the client's
"anything non-pending non-failed renders the success report" fallthrough is invisible in the types.

**Remedy**: export `UPLOAD_STATUSES = ['pending','completed','failed'] as const` +
`type UploadStatus` union from `uploads.ts` (or a tiny `status.ts`), type `UploadStatus.status`
and `UploadRow.status` with it, and import at every comparison site. ~15 lines, no behavior change.
This mirrors exactly what the same PR did right for `ROW_REJECTION_REASONS` and
`STRUCTURAL_FAILURES` in `contacts-csv.ts:25-34` — the convention was known and applied one
concept short.

### 2. Mixed-casing wire payload (MEDIUM)

`CsvIngestPayload` extends `BasePayload`, so the actual JSONB persisted to `job_outbox.payload` is
`{ uploadId, businessId, correlation_id?, outbox_id?, outbox_attempt? }` — two naming conventions
inside one wire object, and the only camelCase payload among ~25 snake_case siblings in
`worker-types.ts`. The doc comment acknowledges the break ("camelCase domain fields (not
snake_case like sibling payloads)") and justifies it by single-tenancy — design.md treats a comment
that justifies an interface inconsistency as a signal to fix the interface. The Task 3 deviations
entry covers the idempotency-key and `as const` divergences, **not** casing, so this is not an
accepted deviation.

**Failure scenario**: any cross-topic ops/debug query over the outbox — e.g.
`payload->>'business_id'` to find all jobs for a tenant, the exact "one owner so ops queries filter
on a single value" motivation `worker-types.ts` itself states for `SKIP_REASON_ARCHIVED_LOCATION` —
silently returns nothing for `csv_ingest` rows.

**Remedy**: rename the wire fields to `upload_id`/`business_id` before the staging flip (#544)
while zero rows exist in any environment; the enqueue helper's camelCase *input* (`EnqueueCsvIngestInput`)
stays as is — the input/wire mapping is exactly what every sibling helper already does. After
launch this becomes a migration-grade change; now it is a 4-file rename.

### 3. ContactsClient.tsx decomposition (MEDIUM)

893 lines is under the skill's hard 1,000 threshold and under the repo's worst precedent
(`approval-client.tsx`, 1,092), but this is a **new** file, and it contains two concerns that are
independent by construction: the upload lane (`UploadPhase` state machine, submit, bounded polling,
report/failed/timed-out rendering — roughly lines 53-215 + 545-745) and the contact list
(fetch-by-`listKey`, delete confirm flow, table, pagination — roughly lines 217-289 + 747-893).
Their only coupling is `setListEpoch(+1)` on ingest completion/delete. Splitting into
`UploadCard.tsx` and `ContactsTable.tsx` (props: `scope`, `onIngestCompleted` / `epoch`) makes each
file independently scannable and stops this island from becoming the next `approval-client.tsx` when
the inevitable watch-mode→send-mode UI lands on this page. Note the diff-coverage deviation waiver
described this file as "~600 lines"; it is 893 — the untested-by-convention waiver was granted
against an understated size, which strengthens the case for keeping each untested unit small.

### 4. Duplicated stored-report parsing (LOW)

`ingest.ts:parseStoredReport` (throw-on-bad-shape) and `uploads.ts:getUploadStatus` +
`asReportRecord` (null-on-bad-shape) both implement string-guard → `JSON.parse` →
`null/object/Array.isArray` shape check → `as IngestReport`. The differing failure posture (worker
impossible-state vs read-side tolerance) is legitimate, but the shared core belongs in one exported
helper in `ingest.ts` (the module `uploads.ts` itself names as "the authoritative shape") — e.g.
`parseIngestReportValue(value: unknown): IngestReport | null`, with the worker wrapping it in its
throw. That also collapses the CLAUDE.md JSONB allowlist from two cited sites to one
shared-parser site, the shape the allowlist's own `accounts.flags` and `provider_dispositions`
entries use. The deviations entry ACCEPTs *documenting* both sites; it does not evaluate the
shared-parser alternative, so this is flagged as new information, not a re-flag.

### 5. Triplicated location-scope policy block (LOW)

Older routes (`kpis`, `agent-team`, `dashboard`) each inline a `scopePolicy.mode === 'aggregate'`
branch, but their branches *differ* (kpis serves an aggregate). The three new contacts routes share
byte-identical semantics — aggregate → 400 with the same message string, then
`resolveDashboardLocation` with `'uniform-not-found'` — repeated three times with the same
explanatory comment. One PR introducing three identical copies of one policy fact is the
duplication trigger firing inside the diff itself. A small helper in
`src/app/api/dashboard/policy.ts` (e.g. `requireLocationScope(request, sql, { accountId, userLocationId })`
returning `{ ok: true, locationId } | { ok: false, response }`) gives the rule one owner and thins
each route by ~10 lines. (The *choice* of 400-on-aggregate and uniform-not-found exposure is an
ACCEPTED Task 4 deviation and is not re-flagged — only the triplication is.)

---

## Checks that passed (evidence)

- **ingest.ts is one deep module, not a god function.** 329 lines with a clean internal
  decomposition: pure `resolveContactMatch` (exported, unit-tested), `upsertCandidates`,
  `findContactByHandle`, `terminalizeUpload`, `parseStoredReport`, `rejectionHistogram`. The
  advisory-lock/transaction contract, PII contract, and idempotency contract are documented at the
  interface, and callers (worker composition root, 60 lines) need none of the internals. The
  `xmax = 0` trick is exactly the kind of hidden complexity a comment should own, and does.
- **contacts-csv.ts** is a pure kernel: clock injected (`todayUtc`), closed enums exported
  `as const`, first-failure-wins row validation in contract order, strict tokenizer EOF posture
  with the why documented. The duplicated RFC-4180 tokenizer vs `src/lib/admin/csv-import.ts` is an
  ACCEPTED containment (file header + deviations) — not re-flagged; no *other* cross-domain
  duplication found.
- **Invariant #15**: every domain module takes `Sql`/`TransactionSql` explicitly; only routes,
  `worker/index.ts`, and the job handler/hook (registered roots) import the singleton. Verified in
  all 8 new production modules.
- **Invariant #10**: `node:crypto` `createHash` in uploads.ts; no `crypto-js` anywhere in the diff.
- **Invariant #12 / thin routes**: all four routes parse → gate → call one module function → map
  result; the longest handler branch is well under 30 lines. Business logic lives in
  `src/lib/solicitation/*`.
- **JSONB discipline**: `tx.json(...)` used in domain modules (never `jsonb()`); the two
  string-guard parse sites carry the carve-out comment and the CLAUDE.md allowlist entry landed in
  the same diff citing both.
- **Error-handling discipline**: no silent catches found. The failed-hook's last-resort
  swallow is documented as the terminal catch and Sentry-reports first; the client's poll `catch {}`
  is deadline-bounded with the why stated; `res.json().catch(() => ({}))` is a deliberate
  tolerate-empty-body parse. The failed-hook's bounded-error-class (never message) PII posture is a
  standout.
- **Glossary fidelity (CONTEXT.md "Solicitation contacts & visits")**: PASS. `solicitation_contacts`
  / `solicitation_visits` / "Normalized handle" (handles.ts header uses the exact coined term) /
  "Consent attestation" (`attestation.ts`, `attested_by_user_id`, `attestation_version`) all match
  the locked vocabulary; `ambiguous_identity`, `duplicate_visit` semantics, and the
  never-auto-merge rule are named identically in code and contract. No concept was renamed into
  different jargon.
- **Test quality**: behavior-first where it matters. Parser and match tests exercise the pure
  functions with real inputs (BOM, U+FFFD, aliases, date formats, escape sequences);
  `ingest.integration.test.ts` and `contacts-repo.integration.test.ts` run match/merge/visit-dedupe/
  raw-CSV-clearing/retry-idempotency against live Postgres (including the terminal-consistency
  CHECK); the offboarding purge cascade is proven live in `integration-lifecycle.test.ts`. The
  mocked unit tests for the worker composition root and uploads.ts assert SQL text/mock wiring —
  acceptable for orchestration-only code and explicitly mirroring the canonical
  `job-outbox-helpers.test.ts` stub style, with the real behavior covered by the live suites.
- **File-size regressions in touched shared files**: none. `worker/index.ts` +15,
  `job-outbox-helpers.ts` +51 (one helper, same shape as siblings), `worker-types.ts` +12,
  `queues.ts` +2 — all pattern-following additions, no spaghetti branches added to existing flows.

## Accepted deviations honored (not re-flagged)

Duplicated CSV tokenizer containment; plain-INSERT `enqueueCsvIngest` (no partial index);
`as const` drop on `CONSENT_ATTESTATION_TEXT`; aggregate→400 + uniform-not-found route posture
(the *behavior* — finding 5 concerns only the triplication); outbox bookkeeping additions;
tenant-scope query strengthenings incl. the unreachable defense-in-depth throw in ingest.ts;
purge DELETE + `TENANT_TABLES` wiring; two JSONB allowlist *sites* (finding 4 concerns only the
duplicated parser implementation); ContactsClient untested-by-convention (finding 3 concerns
size/decomposition, not tests); rejected-row numbering vs physical lines.

---

## Low-confidence appendix (speculative; NOT in the findings table)

- `findContactByHandle` duplicates its query as two branches differing only in the column;
  postgres.js supports dynamic identifiers (`tx(handleColumn)`), but the explicit form is
  arguably safer/clearer. (~50%)
- `rejectionLabel`'s widening cast `(REJECTION_LABELS as Record<string, string>)` papers over the
  possibility of unknown reason tokens in stored reports; a typed lookup with explicit fallback
  would express the same tolerance without a cast. (~60%)
- `upsertCandidates` issues up to ~4 sequential statements per row (~20k round-trips worst case at
  5,000 rows) inside one advisory-locked transaction. Order-dependence (later rows may match
  contacts created earlier in the same file) makes naive batching incorrect, the cap bounds it, and
  the 5-minute UI poll ceiling accommodates it — but if real uploads approach the cap, latency
  through PgBouncer deserves a measurement before optimizing. (~55%, and "measure first" applies)
- Test mocks use `as any` (mirroring the established `job-outbox-helpers.test.ts` style); the
  repworth.md no-`any` rule reads as production-scoped and ESLint permits it in tests, so treated
  as house style. (~40%)
- The subscription-gate read in `handleCsvIngest` happens outside the ingest transaction (TOCTOU
  window between gate and ingest); consistent with other workers' gate posture and harmless in
  watch-mode. (~40%)
- The deviations file's diff-coverage entry understates ContactsClient.tsx as "~600 lines" (actual
  893) — a record-accuracy nit for the orchestrator, not a code issue. (factual, but not a code
  finding)

## Orchestrator triage (2026-07-24)

All five findings ACCEPTED and fixed in 5075c3b0: upload-status union in upload-status.ts; CsvIngestPayload snake_case; ContactsClient split into UploadCard + ContactList; single shared parseIngestReportValue (CLAUDE.md allowlist now cites one site); requireContactsLocationScope helper deduplicating the route preamble.
