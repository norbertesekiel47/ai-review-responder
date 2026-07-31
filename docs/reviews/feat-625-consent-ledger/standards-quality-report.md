# Standards & Maintainability Review — feat/625-consent-ledger

- **Reviewer lane:** STANDARDS & MAINTAINABILITY (thermo-nuclear code-quality skill, read-only)
- **Scope:** `git diff main...HEAD` — 38 files, ~2,375 insertions / 81 deletions
- **Context read:** `docs/superpowers/plans/feat-625-consent-ledger-deviations.md` (all deviations triaged ACCEPT — not re-litigated here)
- **Date:** 2026-07-30

## Verdict summary

This is a high-quality branch. The consent ledger lands as a genuine deepening
of the existing solicitation modules rather than a new layer: `upsertConsent`
is correctly **module-private** inside `ingest.ts` (the D8 "only writer" claim
is structurally true — grep confirms no other production INSERT/UPDATE against
`solicitation_consent`), the batch-builder consumes consent as one `LEFT JOIN`
+ allowlist predicate inside its existing candidate query, and the
`WithholdEvidence` widening is confined to exactly the three owners it should
touch (`restraint-policy.ts`, `batch-view.ts` comment, `batch-report` fixture).
No new `any` in production code, no new JSONB parse sites (the two new
`typeof x === 'string'` guards are in test files, which the CLAUDE.md allowlist
does not govern), invariant #15 respected everywhere (`sql`/`tx` threaded
explicitly), migration comment style matches 086–092, and glossary fidelity is
excellent ("consent ledger", "guarded monotone upsert", case (a)/(b), DR1, D3,
D7, DR3 all used verbatim, no invented synonyms).

Three low-severity findings survive the ≥80% confidence filter. None blocks.

## Findings table (confidence-filtered, ≥80%)

| Severity | Location | Finding | Standard violated / failure scenario |
|---|---|---|---|
| LOW | `src/lib/solicitation/attestation.ts:27` | `isSendEligibleAttestation` is exported with **zero production callers** — `batch-builder.ts:379` inlines the allowlist directly into SQL (`= ANY(...)`), so the function is exercised only by its own unit test (`attestation.test.ts:31`). | repworth.md "no dead code" + "Do not add abstraction layers in anticipation of a feature… wait for the second concrete use case." If #628/#630 send-mode is the intended caller, land the helper there; today it is a second, untested-in-anger owner of the eligibility semantics that can drift from the SQL predicate (e.g., someone adds a version to the array but changes only one gate's null handling). |
| LOW | `src/lib/solicitation/__tests__/ingest.integration.test.ts:50` (`seedUpload`), `batch-builder.integration.test.ts:~130` (`seedPendingUpload`), `contacts-repo.integration.test.ts:84` (`ingestCsv`) | Three near-identical pending-`contact_csv_uploads` seeders were added/extended across the integration suites, with **incidentally divergent `content_sha256` strategies** (`'0'.repeat(64)` vs `uploadId`-derived padding) that encode no semantic difference. | engineering.md "one authoritative owner for each system fact" / task brief's copy-paste-drift check. Failure scenario: a future NOT NULL column or unique constraint on `contact_csv_uploads` now requires three coordinated fixture edits, and the sha divergence invites a wrong conclusion about whether content-dedup exists. A shared `__tests__/helpers` seeder (the `seedTenantAccount` precedent) would own the fixture shape. |
| LOW | `src/lib/solicitation/__tests__/batch-builder.integration.test.ts` | Branch pushes the file **965 → 1,228 lines**, crossing the 1k threshold. | Thermo-nuclear rule 1 (presumptive blocker unless justified). **Waiver accepted here:** splitting a live-DB suite multiplies concurrent vitest processes against the shared DB — the exact #573 deadlock surface — and the suite shares one tenant seed, one advisory lock, and one `afterEach` sweep. The file remains clearly sectioned. Recorded so the next grower of this file decomposes deliberately (e.g., a sibling suite with its own `businessId`) instead of by accretion. |

## Deep-module assessment (as asked)

- **`ingest.ts` — deepened, not leaked.** `upsertConsent` is private; the only
  interface change is `upsertCandidates` taking the whole `UploadRow` instead
  of `uploadId`, which is the right call (five attestation fields threaded as
  one already-loaded row beats a five-parameter signature). The pre-read →
  guarded upsert → event derivation is justified in place by the advisory-lock
  serialization comment; the `RETURNING`-absent no-op branch is documented as
  the §4.3 replay contract. 650 lines — well within bounds.
- **`batch-builder.ts` — the tautology removal is the code-judo move.** The
  old `u.status = 'completed' AND u.attested_at IS NOT NULL AND …` expression
  (always-true by construction) is replaced by a ledger join + allowlist; the
  unit suite pins both the new join predicates and the *absence* of
  `u.attested_at`. No new helper layer was invented for this — correct.
- **`contacts-repo.ts` — acceptable widening.** `deleteContact` gains a
  transaction because the contact delete + consent sweep must be atomic
  (§7.1); the "no FK reaches solicitation_consent, so this sweep is the ONLY
  per-contact deleter" comment is exactly the why-comment the rules ask for.
- **`restraint-policy.ts`** — evidence widening is done at the type, the
  ruleset version bump (`.2` → `.3`) is justified against its own stated bump
  criterion, and the stale v-watch footnote was updated rather than left to rot.
- **Evidence-type leak check:** `attestationVersion`/`WithholdEvidence`
  references outside the sanctioned trio are pre-existing upload-attestation
  UI (`UploadCard.tsx` etc.), untouched by this branch. No leak.
- **Pass-through helpers / premature abstraction:** only the one flagged above
  (`isSendEligibleAttestation`).

## Standards spot-checks (all pass)

- **Migrations 093/094:** header comment style, `SET lock_timeout = '5s'`
  (089/090/092 precedent), DROP+re-ADD CHECK superset pattern (046→058→069→089
  lineage cited in-file), UUIDv7 worker-supplied PK, deny-all RLS with the
  invariant-#14 posture named. The 089→094 drift-guard handoff freezes 089's
  list as a literal and moves the live `ANALYTICS_EVENT_NAMES ⟺ CHECK` guard to
  094 — one authoritative owner, correctly migrated.
- **Registry ripples complete:** `tenant-tables.ts`, `rls-inventory.md`,
  `events.md`, `migrations-log.md` (head 094), `schema-ready.ts`,
  `table-disposition.ts`, purge sweep + `must_be_absent` verification, and the
  bystander-survives integration assertion all landed together.
- **Test quality:** assertions pin behavior, not implementation noise — the
  monotonicity test proves the guard rejected *only* the consent write (visits
  still insert), `updated_at` is read `::text` end-to-end with the microsecond
  gotcha cited, the replay test asserts byte-identical ledger + single event,
  the migration-093 suite asserts the **FK absence** on `attested_by_user_id`
  with an exactly-two count so a later FK is loud, and the tenant-scope test
  proves per-business consent isolation. `process.env.SOLICITATION_WATCH_ENABLED`
  is reset in `afterEach` per suite convention. The `as any` in
  `purge-verification.test.ts:216` follows that file's pre-existing hoisted-mock
  convention (not a new violation class).
- **Verify-gate cleanup fix** (child-first set-based deletes, 120s hook
  timeout) is well-commented with the root cause; the lab-note promotion is
  already flagged in the deviations file.

## Already-flagged (accepted deviations — not findings)

- `table-disposition.ts:386` reason text still claims consent rows "leave with
  the business via the businesses(id) cascade", which the branch's own
  purge-stage/verification comments prove wrong on the purge path. Kept
  verbatim per the locked plan; the spec §7.2 + lab-notes correction is
  already flagged for ship-time promotion in the deviations file. Do not ship
  the *next* release train without that promotion — the reason string is the
  one remaining place a reader can be misled.

## Low-confidence appendix (report-only; below the 80% bar)

- `migration-094-consent-analytics-events.integration.test.ts` is a pure
  SQL-text suite carrying the `.integration.test.ts` name, unlike the
  089 `.test.ts` precedent it copies. The header documents the choice as
  deliberate and harmless (serialized project only); still, the name signals
  "live-DB" to readers and marginally serializes a suite that needs no
  serialization. A rename to `.test.ts` would match the 089 precedent.
- `purge-stages.ts` comment says the consent sweep runs "after the upload
  delete so it sweeps post-SET-NULL rows" — the business-scoped DELETE would
  remove the same rows in either order; the ordering claim slightly overstates
  its own necessity.
- `upsertConsent` runs 2–3 statements per email candidate inside the ingest
  loop (up to ~15k statements for a 5k-row CSV, inside one transaction under
  the advisory lock). Consistent with the loop's existing per-row
  createContact/upsertVisit shape, so not flagged — but if ingest latency ever
  matters, a set-based consent fan-out with `RETURNING`-derived events is the
  obvious restructuring.
- A future non-email channel keyed by phone would not be swept by
  `deleteContact`'s email-handle DELETE; the DR3 email-only CHECK makes this
  unreachable today and the widening rule ("per channel, alongside a new
  attestation text") is the documented gate where this must be revisited.

## Orchestrator triage (2026-07-30)
- L1 dead export: ACCEPTED — removed in 2d36999e.
- L2 cross-suite fixture drift: REJECTED — two of three seeders predate #625 (suites extended, not created); consolidation is standalone cleanup vs the small-diff bias; noted for a future test-hygiene pass.
- L3 suite >1k lines: NO ACTION — reviewer-accepted waiver (#573 live-DB split economics).
