# Step 7 — Spec & Correctness review: feat/541-contacts-csv

Reviewer: spec-correctness agent (read-only). Diff reviewed:
`git diff 991b78c1..HEAD` (merge-base of origin/main), 47 files.
Inputs: intake contract (`feat-541-contacts-csv-intake.json`), locked contract
spec (`docs/superpowers/specs/2026-07-23-contacts-csv-contract-design.md`),
triaged deviations (`feat-541-contacts-csv-deviations.md`, all ACCEPT),
blast-radius (`docs/reviews/feat-541-contacts-csv/blast-radius.md`).

## Verdict summary

The implementation matches the locked #535 contract with high fidelity:
matching rules (§1.2 either-handle match, merge-in, never-auto-merge,
`ambiguous_identity`), visit idempotency (§1.3 `(contact_id, visit_date)`
unique + note refresh via `NULLIF/COALESCE`), validation (§2 closed enums,
bounds, staleness deliberately NOT rejected), ingest lane (§3 one-tx upload +
outbox, one-tx report + raw-CSV NULL, partial accept), attestation (§4
blocking, versioned constant, per-upload), deletion (§5 hard delete + CASCADE +
offboarding purge sweep with live-DB proof), and the suppression-foresight
commitment (§6 normalize-once, stored handle). All 20 promised test titles are
present verbatim; the four intake verification commands pass locally
(`ci:outbox-topics`, `ci:tenant-scope`, `ci:rls-audit`, `ci:static-policy`
all exit 0); the targeted unit suites pass (36/36). Non-goals verified absent
(no `solicitation_batches`, no `build_solicitation_batch`, no suppression
ledger, no per-row consent columns, no send path). Two findings survived the
≥80% confidence filter.

## Findings (≥80% confidence)

### F1 — MAJOR — Route/worker entitlement mismatch strands a past_due owner's upload `pending` forever, retaining the raw CSV indefinitely

- **Files:** `worker/jobs/csv-ingest/index.ts:47-56` (gate) vs
  `src/app/api/dashboard/contacts/uploads/route.ts:28` (route gate);
  root helpers `src/lib/shared/writable-subscription.ts:50-66`,
  `src/lib/shared/subscription-status.ts:54-61`.
- **Defect:** The upload route gates on `requireWritableOwner` →
  `assertWritableSubscriptionStatus`, which **allows `past_due` inside the
  7-day grace window** (`computePastDueRecoveryState` → `ok:true`). The
  csv-ingest worker gates on `subscriptionGrantsFullAccess` (`active` |
  `trialing` **only**) and, on failure, **marks the outbox row COMPLETED and
  leaves the upload row untouched** — no retry, no terminalization, ever.
- **Concrete failure scenario:** An owner whose account is `past_due` (day 2
  of grace — writes still allowed platform-wide) uploads a contacts CSV. The
  route accepts (201), persists the upload row (`status='pending'`,
  `raw_csv` populated) + outbox row. The worker runs seconds later, hits the
  `subscriptionGrantsFullAccess` skip branch, marks the outbox completed, and
  returns. Outcome, permanent: (a) the upload row stays `pending` with the
  **raw CSV — the contract's "largest PII surface" — retained indefinitely**,
  violating the intake invariant "Raw CSV text is NULLed in the same
  transaction as the terminal report (success or terminal failure)" and
  contract §3's "its lifetime is bounded by processing" (processing never
  reaches a terminal state); (b) the UI polls 5 minutes, then shows "Still
  processing — … the import keeps running in the background", which is false
  — nothing will ever run again (the worker comment's "stays pending until
  resubscription re-upload" requires the owner to *guess* they must re-upload);
  (c) the intake's declared broken-in-prod signal ("uploads stuck in
  processing status = report never written") now fires on a routine
  non-broken path, poisoning the alerting semantics. The same permanent
  strand occurs when a subscription flips active→cancelled/past_due between
  route accept and job execution.
- **Why this is not an accepted deviation:** The Task 5 "outbox bookkeeping"
  ACCEPT covers marking the outbox completed on the no-entitlement exit (so
  the watchdog doesn't re-pend); it does not address the route accepting
  what the worker permanently refuses, nor the unbounded raw-CSV retention.
  The worker's own comment names only `pending_payment` / `cancelled` —
  statuses that **cannot pass the route gate at all** — and never `past_due`,
  the one status that deterministically reaches this hole.
- **Suggested fixes (either closes the hole):** (1) make the route's
  entitlement match the worker's — reject uploads unless
  `subscriptionGrantsFullAccess` (simplest; grace-window owners see a clear
  402/403 instead of a silent black hole); or (2) have the worker's
  no-entitlement branch terminalize the upload (`status='failed'`, report
  `error: 'ingest_failed'`-style enum, raw_csv NULLed in the same tx),
  mirroring the failed-hook's coupled write.

### F2 — MINOR — `docs/security/rls-inventory.md` edited outside the allowed edit surface, unlogged

- **File:** `docs/security/rls-inventory.md` (3 rows added for the new
  tables).
- **Defect:** The file matches no glob in the intake's `allowed_edit_surface`
  (even after all three logged surface amendments: `docs/directory.md`,
  `docs/superpowers/plans/**`, and `docs/reviews/**` are allowed;
  `docs/security/**` is not), and no deviations entry records the addition.
  No CI script reads the file (verified: no `rls-inventory` reference under
  `scripts/ci/`), so it was a voluntary doc edit, not a CI-forced one.
- **Assessment:** The content itself is correct and desirable (the doc would
  otherwise go stale, a dangling-ref bug per repworth.md). This is purely a
  process finding: the workflow's surface-tracking contract requires either a
  glob or a logged deviation. Recommend a one-line deviations entry (or a
  step-8 surface note) rather than reverting the edit.

## Checks performed (evidence)

| Check | Result |
|---|---|
| Intake `user_visible_behavior` (6 items) | All implemented: flag-gated page (`page.tsx` `notFound()`), blocking attestation checkbox (button disabled until `attested`; module rejects `attestation_required`), processing→report UX with created/merged/visits/duplicate tiles + rejected `{row, reason}` table + client-side CSV download, partial accept, contact list + confirm-step hard delete, idempotent re-upload (visit unique key + note refresh) |
| Intake `invariants` (11 items) | Held, EXCEPT the raw-CSV-NULLed invariant's outcome on the F1 lane (see above). #1 route persists only (no CSV parsing in route); #2 both couplings in one tx (`uploads.ts:40-51`, `ingest.ts terminalizeUpload`, failed-hook coupled tx); #8 every read/write binds `account_id`/`business_id` (repo doc-comment pattern + bound worker/ingest queries); #11 worker uses `subscriptionGrantsFullAccess`; #13 no `NEXT_PUBLIC` companion (`ci:static-policy` pass); #15 all solicitation modules take `sql`/`tx` params (`ci:db-imports` posture; routes/worker are the composition roots); never-auto-merge (`resolveContactMatch` rejects distinct matches); normalize-once (handles.ts, stored); PII logging (counts/histograms only; failed-hook persists bounded `err.name` only); migration 086 additive-only |
| Intake `edge_cases` (12 items) | All handled: ambiguous_identity, handle merge-in, latest-non-empty-name, duplicate_visit + note refresh, 10-digit US → E.164 / invalid_phone (letters reject), both date formats + future_date, unknown columns ignored + case-insensitive aliases + whole-file header reject, 5 MB/5,000-row/undecodable whole-file rejects, old dates valid, flag-off 404s (all four routes + page), per-business upload targeting with ownership SELECT, idempotent worker retry (advisory lock + terminal-state no-op + natural upserts), note_too_long at 500 |
| `tests_to_add` (20 titles) | All 20 present verbatim (fixed-string grep, one file each) |
| `allowed_edit_surface` | 46/47 files within globs (incl. the three logged amendments); 1 outside → F2 |
| `non_goals` | None built: zero hits for `solicitation_batches` / `build_solicitation_batch`; no suppression-ledger table; no per-row consent columns in 086; no send path |
| Contract spec drift (§1–§6) | None found beyond deviations already ACCEPTed (row-number drift, tokenizer strictness → `undecodable_encoding`, plain-INSERT outbox enqueue, `as const` drop, uniform-not-found route posture) |
| Cross-task integration | Payload shape route↔worker consistent (`CsvIngestPayload` camelCase; OutboxPoller injects `outbox_id`/`outbox_attempt`, `extractOutboxHandle` consumes); `topicToQueue` + worker registration + failed-hook wired; advisory-lock discipline consistent between ingest and failed-hook (same key, lock-first ordering, CAS-gated coupled write); terminal-consistency CHECK satisfied by all three writers (ingest success, structural failure, exhaustion hook); purge DELETE cascades verified against 086 FKs; `xmax = 0` inserted/duplicate discrimination correct incl. same-tx duplicates |
| Verification commands | `ci:outbox-topics`, `ci:tenant-scope`, `ci:rls-audit`, `ci:static-policy` — all pass locally (exit 0) |
| Targeted tests | `handles`, `contacts-csv`, `ingest`, `uploads`, `csv-ingest worker`, `flag-404` — 36/36 pass |

## Low-confidence appendix (NOT findings; <80% confidence or unclear spec)

- **Archived-location uploads:** the POST route checks only
  `businesses.id + account_id`, not location active/archived state; an owner
  could upload contacts for an archived location. Neither the contract nor the
  intake speaks to archived locations, and other read routes use the same
  ownership-only shape — unclear whether this is a gap or intended.
- **No navigation entry:** `/dashboard/contacts` is reachable only by direct
  URL; no sidebar/nav wiring is in the diff (nav files are outside the edit
  surface). Likely deferred to #544's staging flip; flagging only in case it
  was expected here.
- **`filename` length unbounded** into a TEXT column (bounded in practice by
  the multipart body limit); cosmetic at worst.
- **Advisory-lock key collisions:** `hashtext('csv_ingest_' || businessId)` is
  32-bit; cross-business collisions merely over-serialize two businesses'
  ingests — harmless, noting for completeness.
- **In-upload same-handle conflict shadowing:** two rows in one file with the
  same email but different phones both match the first-created contact; the
  second row's phone is silently NOT merged (existing handle never
  overwritten, and a never-seen second phone is dropped without a report
  entry). Matches §1.2's letter ("merges in a new handle it **lacked**");
  whether a dropped-handle count belongs in the report is a product question.
- **Client `report.rejected` unbounded render:** up to 5,000 rejected rows
  render into a 260px-scroll table without virtualization; fine at the cap,
  noting as a perf nicety only.

## Orchestrator triage (2026-07-24)

- MAJOR (worker gate mismatch → stranded pending upload + retained raw CSV): ACCEPTED — fixed in 5075c3b0 (worker reuses the route's writable predicate; inactive subscriptions terminalize via the lock-guarded path with raw_csv NULLed; promised test titles swapped in the intake with user sign-off).
- MINOR (rls-inventory.md out-of-surface edit): ACCEPTED — logged as a deviation; docs/security/rls-inventory.md added to the surface with user sign-off; content kept.
