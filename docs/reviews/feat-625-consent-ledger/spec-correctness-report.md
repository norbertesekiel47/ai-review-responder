# SPEC & CORRECTNESS review — feat/625-consent-ledger

Reviewer: spec-correctness agent, 2026-07-30. Scope: full `git diff main...HEAD`
(38 files, +2375/−81) against `.feature/intake.json`, spec
`docs/superpowers/specs/2026-07-28-consent-ledger-design.md` Part I §2–§8,
amendments §D (#625 row: "unchanged by this doc"), triaged deviations (all
ACCEPT — not re-litigated), and `docs/reviews/feat-625-consent-ledger/blast-radius.md`.

## Verdict summary

The branch implements the contract faithfully. Migration 093 matches the §3.1
contract table column-for-column (types, nullability, both single-value CHECKs,
businesses CASCADE / uploads SET NULL FKs, NO FK on `attested_by_user_id`, total
unique scope index, RLS enabled with zero policies) and every one of those facts
is pinned by the 093 shape suite, including the exactly-two-FKs absence
assertion. Migration 094 is a strict superset of 089's CHECK list and takes over
the live CHECK⟺`ANALYTICS_EVENT_NAMES` drift guard (089's suite now pins its own
historical list). The §4.2 upsert SQL is semantically identical to the spec SQL.
DR1/DR3/D7/D8 hold. All 9 `tests_to_add` titles exist verbatim with real
assertions (one mechanism caveat — finding 1). All 7 intake edge cases are
covered. Three low-severity findings; no High/Medium.

## Findings table (≥80% confidence only)

| Severity | Location | Finding | Concrete failure scenario |
|---|---|---|---|
| LOW | `src/lib/solicitation/__tests__/ingest.integration.test.ts:578` | The promised "monotone upsert idempotency: replaying the same csv_ingest job re-writes identical values as a no-op without updated_at churn" test never reaches `upsertConsent`: the replay hits the `status !== 'pending'` terminal short-circuit in `ingestContactsCsvUpload` (ingest.ts:158-163) and returns the stored report before any write. The equal-`attested_at` branch of the §4.2 guard — the mechanism §4.3 describes, and the only path where "identical values" actually reach the upsert (duplicate email rows within one CSV, since a whole-tx replay can never re-enter with committed prior writes) — is unexercised by any test; the monotonicity test only covers strictly-older `attested_at`. | Regress the guard from `>` to `>=` (or drop it in a refactor that "simplifies" the WHERE): within-file duplicate emails then churn `updated_at` on every ingest, violating §4.3's no-churn contract, and the whole suite stays green. |
| LOW | `src/lib/solicitation/attestation.ts:27` | `isSendEligibleAttestation` is exported with zero production callers — `batch-builder.ts` inlines `SEND_ELIGIBLE_ATTESTATION_VERSIONS` into SQL via `ANY(...)`; only `attestation.test.ts` calls the function. repworth.md forbids abstraction ahead of the second concrete use case; the intended consumer is #630's dispatch gate, which does not exist yet. | Dead export until #630; fallow/unused-export sweeps flag it, and #630 may implement its gate in SQL (like batch-builder did), leaving it permanently uncalled. |
| LOW | `docs/security/rls-inventory.md:35` | File changed outside `allowed_edit_surface`. The mid-run approval exists only as prose inside the `estimated_diff_size` re-classification note ("tenant-tables/rls-inventory/purge sweep"); unlike the three recorded amendments (tenant-tables.ts, worker/**, 094 files, batch-report test), the surface array in BOTH intake copies was never amended to include it. | The edit-surface contract and its audit trail disagree: a later reviewer diffing files-changed vs the surface array flags this as unapproved drift; the row itself is correct and needed by the tenant-table registration. |

## Field-by-field verification (evidence)

**goal / user_visible_behavior** — all six behaviors verified in code + tests:
consent row per valid email row inside the ingest tx (`ingest.ts` `upsertConsent`,
called from `upsertCandidates` after the visit upsert, so dedupe cannot skip it);
v2 text + `consent_attestation_v2` stamp (`attestation.ts`, `attestation.test.ts`
checks the three §2.3 properties and the dropped watch-mode disclaimer); v1-only
contacts withhold case (b) (`batch-builder.integration.test.ts:1078`); §1.2 trap
remedy (`:1104` + ingest `:494`); delete sweeps by handle in the same tx
(`contacts-repo.ts:124`, tested `:229`); purge disposition + `must_be_absent` +
explicit sweep (`purge-stages.ts:318`, `purge-verification.ts`, PurgeWorker +
lifecycle bystander-survives pair).

**§4.2 guarded upsert** — SQL matches the spec byte-for-semantics (same column
set, same `WHERE EXCLUDED.attested_at > solicitation_consent.attested_at`).
Pre-read → upsert pairing is race-free for the event derivation because ingest is
the sole *inserting* writer and is serialized per business by
`acquireCsvIngestLock` taken before the upload read. Replay idempotency: replay
short-circuits at terminal status (stronger than the guard); within-file
duplicates hit the equal-`attested_at` no-op (no `updated_at` churn, no duplicate
event — same-tx visibility makes the pre-read see the first row). `RETURNING id`
is absent when the guard rejects → deliberate no-op branch. `recorded` fires only
on true insert; `upgraded` only on a version change, keyed
`<row_id>_<to_version>` with `ON CONFLICT (event_key) DO NOTHING` backstop.
Events carry channel/basis/versions only — the ingest suite asserts the handle
never appears in properties. µs-truncation: both operands in one statement
(recorded in the doc comment, per the intake edge case); tests read timestamps
`::text` end-to-end.

**loadCandidateWindow swap** — only the SELECT list changed (dropped
`latest_visit.upload_id`, added the two consent columns) plus one LEFT JOIN on
the ledger's unique key (no fan-out possible). The inner `contact_csv_uploads u
… status='completed'` join, latest-visit selection, `latest_evaluation` rotation
ordering (`decided_at ASC NULLS FIRST`), poolCount, and prior-send queries are
untouched. `consent_attested` can never be NULL (`consent.id IS NOT NULL` is the
first conjunct). Case (a)/(b) evidence mapping per §6.1 verified in the stored
rows (integration tests parse real `solicitation_asks.evidence` through
`parseEvidence` and 090's CHECK via the real INSERT). Phone-only/NULL-email
contacts fall to case (a) — the DR3-consistent fail-closed outcome.

**evaluateAsk purity** — logic unchanged; the only edit is the D10-mandated
evidence field addition at the `no_consent` return. `.3` bump present with the
`.2`-precedent doc comment.

**Non-goals / DR sweep** — no `solicitation_outreach` touch; no consent snapshot
stamping; no suppression read or write anywhere in consent code (grep-verified);
no `revoked_at` (093 suite asserts the absence); no sms row path (CHECK +
DR3 test); no new env vars/flags (constants only); no new withhold reason; basis
CHECK is `owner_attested` only; spec §10 test 7 + the
`solicitation_consent_missing_at_dispatch` event correctly absent (deferred to
#630 per the intake non-goal). Writers census: exactly one INSERT/UPDATE site
(ingest) and two mandated DELETE sites (contact delete §7.1, purge sweep §7.2).

**Invariants** — all 12 verified; notables: `attested_by_user_id` no-FK asserted
live; no `account_id` column (SQL-text test); UUIDv7 worker-supplied (no DB
default, asserted); RLS deny-all (asserted); events not client-postable
(`events.test.ts` pins both names out of `CLIENT_ENQUEUEABLE_EVENT_NAMES`);
tenant registration in `TENANT_TABLES` with the EXPLICIT-list workaround removed.

**tests_to_add** — 9/9 titles verbatim; bodies assert the claimed behavior
(finding 1 is the one mechanism-level caveat). Edge cases 7/7 covered.

**Blast radius** — every listed importer checked against the new semantics.
Key results: `BatchReport.tsx` `evidenceLine` never reads
`upload_id`/`attestation_version`, so the widened shape breaks no rendering;
**no stored `.2`-era `no_consent` evidence can exist** (the pre-#625 tautology
made `no_consent` unreachable in v-watch — the old restraint-policy header says
so), so the serialization widening has zero backward-compat exposure;
`run-spine.ts`/`GhostPipeline.tsx` import only `WithholdReason`/`WITHHOLD_REASONS`
(unchanged); `uploads.ts`/`contacts/page.tsx` pick up v2 automatically (intended);
`csv-ingest` worker + failed-hook: `ingestContactsCsvUpload` signature unchanged;
`deleteContact` still returns `Promise<boolean>` with identical 404 semantics
(now `sql.begin`-wrapped — callers pass `Sql`, fine); purge-stage sweep runs
inside the existing advisory-locked tx after the upload delete (correct
SET-NULL ordering, asserted in the lifecycle test).

## Low-confidence appendix (NOT findings)

- **§8.1 literal vs implemented `upgraded` trigger.** Spec says the event fires
  when "the §4.2 `DO UPDATE` branch fires"; code fires it only when
  `attestation_version` changes. A same-version refresh (overlapping re-upload,
  later `attested_at`) updates the row silently. This matches the intake's
  observability wording (from_version/to_version as the v1→v2 migration metric)
  and avoids from==to noise in the #633 flip evidence; `docs/analytics/events.md`
  documents the implemented trigger. Deliberate-looking narrowing, but nobody
  recorded the delta against the spec sentence.
- **Mixed evidence state outside the §6.1 case table.** A non-eligible consent
  row whose upload was deleted (`source_upload_id` SET NULL) produces evidence
  `{upload_id: null, attestation_version: 'consent_attestation_v1'}` — neither
  "both null" nor "both populated". #629's copy should discriminate on
  `attestation_version`, not `upload_id`.
- **`deleteContact` does not take the csv-ingest advisory lock.** A delete
  interleaving with an in-flight ingest of the same handle can (a) misclassify
  the analytics event (`upgraded` where `recorded` is truer) or (b) leave a
  contact-less consent row. (b) is inert — batch-builder joins from contacts —
  and the row was legitimately re-attested by that in-flight upload, so no
  consent-the-owner-didn't-give arises.
- **`TABLE_DISPOSITIONS` reason text repeats spec §7.2's wrong cascade claim**
  ("leave with the business via the businesses(id) cascade"). Kept verbatim per
  the locked plan; the real mechanics live in purge-verification/purge-stages
  comments. Resolved deviation — recorded here only as the ship-time reminder to
  promote the correction into the spec + lab notes.
- **Rows rejected at contact-match mint no consent row** (the `decision.action
  === 'reject'` `continue` precedes `upsertConsent`). §4.1 says "per valid CSV
  row"; treating match-rejected rows as not-valid is the fail-closed reading and
  almost certainly right, but the spec doesn't say it explicitly.

## SPEC VERDICT

No High or Medium findings. Three Low findings (test-mechanism gap on one
promised test, one dead export, one surface-bookkeeping drift) — none blocks
merge on correctness grounds.

## Orchestrator triage (2026-07-30)
- L1 guard-branch/idempotency coverage: ACCEPTED — fixed in 2d36999e (equal-attested_at test, mutation-verified).
- L2 dead export: ACCEPTED — isSendEligibleAttestation removed in 2d36999e.
- L3 rls-inventory surface record: ACCEPTED — glob added retroactively to both intake copies.
